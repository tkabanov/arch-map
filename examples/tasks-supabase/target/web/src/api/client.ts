import { createClient } from '@supabase/supabase-js';
export const supabase = createClient('/local-api', 'demo-public-key');
