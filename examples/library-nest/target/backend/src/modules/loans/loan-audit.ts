import { Module, Injectable } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Notice } from '../../models/notices';
import { LOAN_OPENED } from '../../events';
import { OnDomainEvent } from '../notifications/decorators';

@Injectable()
export class LoanAuditService {
    constructor(@InjectModel(Notice) private records: typeof Notice) {}
    @OnDomainEvent(LOAN_OPENED)
    record() { return this.records.create({ title: 'Loan opened' }); }
}
@Module({ imports: [SequelizeModule.forFeature([Notice])], providers: [LoanAuditService] })
export class LoanAuditModule {}
