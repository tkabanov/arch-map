import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Loan } from '../../models/loans';
import { LibraryBus, LoanOpened } from '../../events';

@Injectable()
export class LoanService {
    constructor(@InjectModel(Loan) private records: typeof Loan, private domainEvents: LibraryBus) {}
    list() { return this.records.findAll(); }
    create() { this.domainEvents.publish(new LoanOpened('sample-loan')); return this.records.create({}); }
}
@Controller('loans')
export class LoanController {
    constructor(private service: LoanService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Loan])], providers: [LoanService], controllers: [LoanController] })
export class LoanModule {}
