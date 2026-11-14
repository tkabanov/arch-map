import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { CatalogGateway } from './catalog';
import { Branch } from '../../models/branches';

@Injectable()
export class BranchService {
    constructor(@InjectModel(Branch) private records: typeof Branch, private catalog: CatalogGateway) {}
    list() { this.catalog.lookup(); return this.records.findAll(); }
    create() { return this.records.create({}); }
}
@Controller('branches')
export class BranchController {
    constructor(private service: BranchService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Branch])], providers: [BranchService], controllers: [BranchController] })
export class BranchModule {}
