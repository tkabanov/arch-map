export const LOAN_OPENED = 'loan.opened';
export class LoanOpened { constructor(public loanId: string) {} }
export class LibraryBus { publish(event: LoanOpened) { return event; } }
