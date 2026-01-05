-- Replace TEAM_ID with your team's UUID
-- Example inserts just to verify the app works end-to-end.

-- Insert a team (or create via Supabase UI)
-- insert into teams(name) values ('MVVC 14 Black') returning id;

-- Knowledge chunk example:
-- insert into knowledge_chunks(team_id, season, title, content, tags)
-- values (
--   'TEAM_ID',
--   'spring',
--   'Spring constraints',
--   'Troy out for spring. Steven returned 2026-01-01. Prioritize stability and low error leakage.',
--   array['constraints','availability']
-- );

-- Metrics example:
-- insert into player_metrics(team_id, season, player_name, metric_key, metric_value)
-- values
-- ('TEAM_ID','fall','Jayden','pass_avg',1.42),
-- ('TEAM_ID','fall','Jayden','receive_ta',216),
-- ('TEAM_ID','fall','Bodhi','pass_avg',1.51),
-- ('TEAM_ID','fall','Bodhi','receive_ta',101);
