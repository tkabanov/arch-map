import { Module, Injectable } from '@nestjs/common';
import { LOAN_OPENED, LibraryBus } from '../../events';
import { OnDomainEvent } from './decorators';
export class EmailGateway { send() { return 'queued'; } }
@Injectable()
export class NotificationService {
    constructor(private email: EmailGateway, private domainEvents: LibraryBus) {}
    @OnDomainEvent(LOAN_OPENED)
    onLoan() { return this.email.send(); }
}
@Module({ providers: [NotificationService] })
export class NotificationModule {}
