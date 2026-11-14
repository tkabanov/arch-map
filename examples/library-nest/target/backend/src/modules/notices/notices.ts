import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Notice } from '../../models/notices';

@Injectable()
export class NoticeService {
    constructor(@InjectModel(Notice) private records: typeof Notice) {}
    list() { return this.records.findAll(); }
    create() { return this.records.create({}); }
}
@Controller('notices')
export class NoticeController {
    constructor(private service: NoticeService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Notice])], providers: [NoticeService], controllers: [NoticeController] })
export class NoticeModule {}
