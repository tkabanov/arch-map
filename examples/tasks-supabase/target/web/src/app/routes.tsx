export const routes = [{ path: '/boards', handle: { title: 'Boards' }, lazy: () => import('../features/boards/Board') }];
