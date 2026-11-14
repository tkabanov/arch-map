export const listBooks = () => fetch('/books');
export const openLoan = () => fetch('/loans', { method: 'POST' });
export const reserve = () => fetch('/reservations', { method: 'POST' });
