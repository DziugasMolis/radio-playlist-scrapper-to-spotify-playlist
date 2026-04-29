BEGIN;

DELETE FROM songs
WHERE played_time !~ '^\d{1,2}:\d{2}(:\d{2})?$'
   OR played_time::time < TIME '06:00:00'
   OR played_time::time > TIME '22:00:00';

COMMIT;