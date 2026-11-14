import { Table, Column, Model } from 'sequelize-typescript';
@Table({ tableName: 'books' })
export class Book extends Model {
    @Column({ primaryKey: true, allowNull: false, type: 'UUID' }) id!: string;
    @Column({ type: 'TEXT' }) title!: string;
}
