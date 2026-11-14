import type { TasksPort } from './port';
import { supabase } from '../../client';
export const tasksPort: TasksPort = {
    async list() { return supabase.from('tasks').select('*'); },
    async complete() { return supabase.rpc('complete_task', { task_id: 'sample-task' }); },
    async summarize() { return supabase.functions.invoke('task-summary', { method: 'POST' }); },
    async comment() { return supabase.from('comments').insert({ title: 'Board note' }); },
    async signIn() { return supabase.auth.signInWithOtp({ email: 'reader@example.test' }); },
};
