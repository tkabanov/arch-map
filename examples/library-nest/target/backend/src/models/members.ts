import { Table, Column, Model } from 'sequelize-typescript';
@Table({ tableName: 'members' })
export class Member extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
}
