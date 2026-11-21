import { z } from 'zod';
import type { getValidConnectorToken } from './oauth';

const address = z.email().refine((value) => /^[\x21-\x7e]+$/.test(value));
const headerId = z.string().max(500).regex(/^<[\x21-\x3b\x3d\x3f-\x7e]+>$/);
export const replyTarget = z.object({
  to: address,
  subject: z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  internetId: headerId.optional(),
});
export type ReplyTarget = z.infer<typeof replyTarget>;

const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const outlook = 'https://graph.microsoft.com/v1.0/me';
type GoogleMessage = {
  id: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> };
};
type OutlookMessage = {
  id: string; conversationId?: string; subject?: string; isDraft?: boolean; sentDateTime?: string;
  from?: Recipient; replyTo?: Recipient[];
};
type Recipient = { emailAddress?: { address?: string } };

async function providerJson<T>(url: string, headers: HeadersInit): Promise<T | null> {
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('reply_source_unavailable');
  return response.json() as Promise<T>;
}

/** Read headers only. An answered, deleted, ambiguous or outbound thread cannot yield a draft. */
export async function readReplyTarget(
  auth: Awaited<ReturnType<typeof getValidConnectorToken>>, messageId: string, threadId: string, account: string,
): Promise<ReplyTarget | undefined> {
  if (auth.kind !== 'email' || !address.safeParse(account).success) return;
  const headers = { authorization: `Bearer ${auth.accessToken}` };
  let fields: unknown;
  if (auth.provider === 'google') {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const name of ['From', 'Reply-To', 'Subject', 'Message-ID']) params.append('metadataHeaders', name);
    const thread = await providerJson<{ messages?: GoogleMessage[] }>(`${gmail}/threads/${encodeURIComponent(threadId)}?${params}`, headers);
    const messages = thread?.messages ?? [];
    const message = messages.at(-1);
    if (message?.id !== messageId || !message.labelIds || message.labelIds.some((label) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label))) return;
    const get = (name: string) => (message.payload?.headers ?? []).filter((entry) => entry.name.toLowerCase() === name);
    const recipients = get('reply-to').length ? get('reply-to') : get('from');
    if (recipients.length !== 1) return;
    const raw = recipients[0]!.value.trim();
    // Accept a bare mailbox or a single name-addr. Ambiguous address lists fail closed.
    const to = /^(?:"(?:[^"\\]|\\.)*"|[^,<>"\r\n]*)\s*<([^<>]+)>$/.exec(raw)?.[1] ?? raw;
    const internetId = get('message-id')[0]?.value;
    if (!headerId.safeParse(internetId).success) return;
    fields = { to, subject: get('subject')[0]?.value, messageId, threadId, internetId };
  } else {
    const params = new URLSearchParams({
      '$filter': `conversationId eq '${threadId.replaceAll("'", "''")}'`,
      '$select': 'id,conversationId,subject,isDraft,sentDateTime,from,replyTo',
      '$top': '50',
    });
    const thread = await providerJson<{ value?: OutlookMessage[]; '@odata.nextLink'?: string }>(`${outlook}/messages?${params}`, headers);
    if (thread?.['@odata.nextLink']) return;
    const message = thread?.value?.find((item) => item.id === messageId && item.conversationId === threadId);
    if (!message?.sentDateTime || message.isDraft || !message.from?.emailAddress?.address
      || message.from.emailAddress.address.toLowerCase() === account.toLowerCase()
      || thread?.value?.some((item) => item.id !== messageId && (item.isDraft || !item.sentDateTime || Date.parse(item.sentDateTime) >= Date.parse(message.sentDateTime!)))) return;
    const recipients = message.replyTo?.length ? message.replyTo : [message.from];
    if (recipients.length !== 1) return;
    fields = { to: recipients[0]?.emailAddress?.address, subject: message.subject, messageId, threadId };
  }
  const parsed = replyTarget.safeParse(fields);
  if (parsed.success && parsed.data.to.toLowerCase() !== account.toLowerCase()) return parsed.data;
}

export async function sendThreadReply(
  auth: Awaited<ReturnType<typeof getValidConnectorToken>>, target: ReplyTarget, body: string,
): Promise<string> {
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' };
  if (auth.provider === 'microsoft') {
    const response = await fetch(`${outlook}/messages/${encodeURIComponent(target.messageId)}/reply`, {
      method: 'POST', headers, body: JSON.stringify({ comment: body }),
    });
    if (!response.ok) throw new Error(`outlook_reply_failed:${response.status}`);
    return target.messageId;
  }

  if (!target.internetId) throw new Error('reply_source_unavailable');
  const encode = (value: string) => btoa(Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''));
  const subject = target.subject;
  const encodedSubject = /^[\x20-\x7e]+$/.test(subject) ? subject
    : Array.from(subject.matchAll(/.{1,10}/gu), ([part]) => `=?UTF-8?B?${encode(part)}?=`).join('\r\n ');
  const mime = [
    `To: ${target.to}`, `Subject: ${encodedSubject}`, `In-Reply-To: ${target.internetId}`,
    `References: ${target.internetId}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', encode(body),
  ].join('\r\n');
  const response = await fetch(`${gmail}/messages/send`, {
    method: 'POST', headers,
    body: JSON.stringify({ threadId: target.threadId, raw: encode(mime).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }),
  });
  if (!response.ok) throw new Error(`gmail_reply_failed:${response.status}`);
  const sent = await response.json() as { id?: string; threadId?: string };
  if (!sent.id || sent.threadId !== target.threadId) throw new Error('reply_receipt_missing');
  return sent.id;
}
