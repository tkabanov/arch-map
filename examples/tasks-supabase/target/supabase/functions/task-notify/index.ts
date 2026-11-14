import { supabase, defineRouter, defineRoute } from '../helpers/runtime.ts';
export async function notify() {
    await supabase.from('comments').insert({ title: 'Summary ready' });
    await supabase.storage.from('attachments').upload('summary.txt', 'Ready');
    await fetch('https://mail.example.test/send', { method: 'POST' });
    return { sent: true };
}
defineRouter({ basePath: '/task-notify', routes: [defineRoute({ method: 'POST', path: '', authRequired: true, handler: notify })] });
