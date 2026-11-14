import { Table, Column, Model, ForeignKey } from 'sequelize-typescript';
import { Member } from './members';
@Table({ tableName: 'reservations' })
export class Reservation extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
    @ForeignKey(() => Member)
    @Column({ type: 'UUID' }) referenceId!: string;
}
