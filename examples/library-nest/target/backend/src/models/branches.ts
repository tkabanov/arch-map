import { Table, Column, Model } from 'sequelize-typescript';
@Table({ tableName: 'branches' })
export class Branch extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
}
