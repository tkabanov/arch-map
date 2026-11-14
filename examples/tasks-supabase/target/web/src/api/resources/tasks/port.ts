export interface TasksPort { list(): Promise<unknown>; complete(): Promise<unknown>; summarize(): Promise<unknown>; comment(): Promise<unknown>; signIn(): Promise<unknown>; }
