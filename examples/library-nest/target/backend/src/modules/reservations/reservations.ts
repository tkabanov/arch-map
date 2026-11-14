import { Module, Injectable, Controller, Get, Post } from '@nestjs/common';
import { InjectModel, SequelizeModule } from '@nestjs/sequelize';
import { Reservation } from '../../models/reservations';

@Injectable()
export class ReservationService {
    constructor(@InjectModel(Reservation) private records: typeof Reservation) {}
    list() { return this.records.findAll(); }
    create() { return this.records.create({}); }
}
@Controller('reservations')
export class ReservationController {
    constructor(private service: ReservationService) {}
    @Get() list() { return this.service.list(); }
    @Post() create() { return this.service.create(); }
}
@Module({ imports: [SequelizeModule.forFeature([Reservation])], providers: [ReservationService], controllers: [ReservationController] })
export class ReservationModule {}
