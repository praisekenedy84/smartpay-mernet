-- Run this on your attendance DB to disable the trigger
-- The poller.js now handles classification instead

DROP TRIGGER IF EXISTS trg_process_access_event ON attlog;

-- Verify it's gone
SELECT tgname FROM pg_trigger WHERE tgrelid = 'attlog'::regclass;
