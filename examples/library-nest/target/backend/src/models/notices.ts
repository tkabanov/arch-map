import { Table, Column, Model, ForeignKey } from 'sequelize-typescript';
import { Loan } from './loans';
@Table({ tableName: 'notices' })
export class Notice extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
    @ForeignKey(() => Loan)
    @Column({ type: 'UUID' }) referenceId!: string;
}
