-- Grant BYPASSRLS to the API role so it can query all tables via direct pg Pool
-- connection without Supabase Auth session context. App-level tenant isolation
-- is enforced by requireAuth middleware and res.locals.exporterId in every route.
ALTER USER exportos_app BYPASSRLS;
