-- @contract: additive
-- Split the AI permission in two: ai.customer.manage (the customer-facing AI)
-- and ai.teammate.manage (the teammate AI). Every role that holds the old
-- assistant.manage grant gets both new grants, so nobody gains or loses access.
-- The old permission row and its grants stay untouched so an app version that
-- is still running keeps working. Replay-safe: every insert skips what exists.
INSERT INTO "permissions" ("id", "key", "category", "description", "is_system", "created_at")
VALUES
  (gen_random_uuid(), 'ai.customer.manage', 'ai', 'Manage the customer-facing AI: identity, voice, knowledge, guidance, and tools', true, now()),
  (gen_random_uuid(), 'ai.teammate.manage', 'ai', 'Manage the teammate AI: Copilot knowledge and capabilities, and the Slack agent', true, now())
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), old_grant."role_id", new_perm."id"
FROM "role_permissions" old_grant
JOIN "permissions" old_perm ON old_perm."id" = old_grant."permission_id" AND old_perm."key" = 'assistant.manage'
JOIN "permissions" new_perm ON new_perm."key" IN ('ai.customer.manage', 'ai.teammate.manage')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
