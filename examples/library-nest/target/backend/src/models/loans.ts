import { Table, Column, Model, ForeignKey } from 'sequelize-typescript';
import { Book } from './books';
@Table({ tableName: 'loans' })
export class Loan extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
    @ForeignKey(() => Book)
    @Column({ type: 'UUID' }) referenceId!: string;
}
