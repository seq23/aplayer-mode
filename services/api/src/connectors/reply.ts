import { z } from 'zod';
import type { getValidConnectorToken } from './oauth';

const address = z.email().refine((value) => /^[\x21-\x7e]+$/.test(value));
export const replyTarget = z.object({
  to: address,
  subject: z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f]+$/),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
});
export type ReplyTarget = z.infer<typeof replyTarget>;

const outlook = 'https://graph.microsoft.com/v1.0/me';
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
  if (auth.kind !== 'email' || auth.provider !== 'microsoft' || !address.safeParse(account).success) return;
  const headers = { authorization: `Bearer ${auth.accessToken}` };
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
  const parsed = replyTarget.safeParse({ to: recipients[0]?.emailAddress?.address, subject: message.subject, messageId, threadId });
  if (parsed.success && parsed.data.to.toLowerCase() !== account.toLowerCase()) return parsed.data;
}

export async function sendThreadReply(
  auth: Awaited<ReturnType<typeof getValidConnectorToken>>, target: ReplyTarget, body: string,
): Promise<string> {
  if (auth.kind !== 'email' || auth.provider !== 'microsoft') throw new Error('reply_source_unavailable');
  const response = await fetch(`${outlook}/messages/${encodeURIComponent(target.messageId)}/reply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ comment: body }),
  });
  if (response.status !== 202) throw new Error(`outlook_reply_failed:${response.status}`);
  return target.messageId;
}
