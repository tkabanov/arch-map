import { supabase, defineRouter, defineRoute, SummaryRequest, SummaryResponse } from '../helpers/runtime.ts';
export async function summarize() {
    const tasks = await supabase.from('tasks').select('*');
    const count = await supabase.rpc('task_count');
    await supabase.storage.from('attachments').download('summary.txt');
    await fetch('/functions/v1/task-notify', { method: 'POST' });
    return { tasks, count };
}
defineRouter({ basePath: '/task-summary', routes: [defineRoute({ method: 'POST', path: '', authRequired: true, requestSchema: { body: SummaryRequest }, responseSchema: SummaryResponse, handler: summarize })] });
