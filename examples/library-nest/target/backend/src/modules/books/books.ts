import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Book } from '../../models/books';

@Injectable()
export class BookService {
    constructor(@InjectModel(Book) private records: typeof Book) {}
    list() { return this.records.findAll(); }
    create() { return this.records.create({}); }
}
@Controller('books')
export class BookController {
    constructor(private service: BookService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Book])], providers: [BookService], controllers: [BookController] })
export class BookModule {}
