// Supabase connection for every page on this site.
//
// Fill these in from your Supabase project: Settings > API.
//
// The anonymous key is meant to be public. It carries no privileges of its own;
// every table is governed by row level security, so what this key can read or
// write is exactly what the policies in supabase/migrations allow.
//
// The service role key is a different matter. It bypasses row level security
// entirely, so it must never appear in this file or anywhere else the browser
// can reach it.

window.SUPABASE_URL = "https://pbyzmmjxuyumoofziuen.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_D8DcEEaApVpvfO3JNRTPEQ_E83bBgLF";

// Read the map from Supabase when it is reachable, and fall back to the file
// published alongside this page when it is not. The public map is the part
// someone opens during an emergency, so it degrades to last-known data rather
// than failing. 
window.FALLBACK_GEOJSON = "./data/hospitals.geojson";
