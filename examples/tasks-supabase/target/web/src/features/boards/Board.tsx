import { tasksPort } from '../../api/resources/tasks/live';
export function Component() {
    return <section><button onClick={() => tasksPort.list()}>Refresh tasks</button><button onClick={() => tasksPort.summarize()}>Summarize</button><button onClick={() => tasksPort.comment()}>Add comment</button></section>;
}
