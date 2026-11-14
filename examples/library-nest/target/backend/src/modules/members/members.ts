import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Member } from '../../models/members';

@Injectable()
export class MemberService {
    constructor(@InjectModel(Member) private records: typeof Member) {}
    list() { return this.records.findAll(); }
    create() { return this.records.create({}); }
}
@Controller('members')
export class MemberController {
    constructor(private service: MemberService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Member])], providers: [MemberService], controllers: [MemberController] })
export class MemberModule {}
