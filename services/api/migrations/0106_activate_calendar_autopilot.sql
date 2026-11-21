-- 0106: activate the two calendar Autopilot classes (21 Nov 2026). Additive only.
--
-- docs/31: activation is a separate, reviewed migration that records its receipt in
-- evidence_ref. Owner approval 21 Nov 2026 (App Review resubmission of build with PR #91,
-- fresh-reviewer Ship-ready PASS ace6e86ac1b93f488). Only calendar.create (Undo deletes the
-- event) and calendar.reschedule (Undo restores the time) are activated: both are reversible.
-- Every other class stays inactive. The Worker's AUTOPILOT_ENABLED_CLASSES (wrangler.jsonc,
-- production) is the second, per-class switch; deactivating here stops every existing rule.
update public.autopilot_action_classes
   set activation_status = 'active',
       evidence_ref = 'owner-approval-2026-11-21; PR #91 ship-ready PASS ace6e86ac1b93f488; PR activating 0106',
       activated_at = now(),
       updated_at = now()
 where class_key in ('calendar.create', 'calendar.reschedule')
   and activation_status = 'inactive';
