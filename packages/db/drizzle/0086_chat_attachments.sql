-- Image/file attachments on chat messages. Stored as a JSONB array of
-- { url, name, contentType, size } refs (the upload pipeline returns a public
-- URL). Null for text-only messages.

ALTER TABLE "chat_messages" ADD COLUMN "attachments" jsonb;
