/* Field Measure — connection settings.
   These two values are meant to be public. The publishable key can only do what
   the database's Row Level Security policies allow, which is "read and write your
   own row and nobody else's". Never put a key labelled "secret" in this file. */
window.FM_CONFIG = {
  supabaseUrl: 'https://hnrwtrwatephqeifnbia.supabase.co',
  supabaseKey: 'sb_publishable_7EEnUfnh1z2OQ68F3GbEKA_cmyZ5WjP',
  table: 'field_measure_state'
};
