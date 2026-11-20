import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type Vehicle = 'car' | 'bike2' | 'cycle' | 'walk';

export interface UserSettings {
  tiles: string[];
  hidden: string[];
  vehicle: Vehicle;
  dark: boolean;
  alerts: { commute: boolean; weatherTrip: boolean; briefing: boolean; quiet: boolean };
  quietStart: string;
  quietEnd: string;
  waterGoal: number;
  waterIntervalMin: number;
  wakeStart: string;
  wakeEnd: string;
  walkReminder: boolean;
  waterOn: boolean;
  /** News language: 'ml' Malayalam or 'en' English. */
  newsLang: 'en' | 'ml';
  /** Daily water goal in millilitres. */
  waterGoalMl: number;
  /** News topics the user picked for "For you" (empty: a mix of everything). */
  newsTopics: string[];
}

export const DEFAULT_SETTINGS: UserSettings = {
  tiles: ['commute', 'weather', 'water', 'today', 'briefing'],
  hidden: [],
  vehicle: 'car',
  dark: false,
  alerts: { commute: true, weatherTrip: true, briefing: false, quiet: true },
  quietStart: '22:00',
  quietEnd: '07:00',
  waterGoal: 8,
  waterIntervalMin: 90,
  wakeStart: '07:00',
  wakeEnd: '21:00',
  walkReminder: false,
  waterOn: true,
  newsLang: 'ml',
  waterGoalMl: 2500,
  newsTopics: [],
};

@Entity()
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Index({ unique: true }) @Column() email: string;
  @Column() passwordHash: string;
  @Column() name: string;
  @Column({ default: 'Kochi' }) city: string;
  @Column('real', { default: 9.9312 }) lat: number;
  @Column('real', { default: 76.2673 }) lon: number;
  @Column('simple-json') settings: UserSettings;
  @CreateDateColumn() createdAt: Date;
}

@Entity()
export class SavedRoute {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() userId: number;
  @Column() name: string;
  @Column() fromName: string;
  @Column('real') fromLat: number;
  @Column('real') fromLon: number;
  @Column() toName: string;
  @Column('real') toLat: number;
  @Column('real') toLon: number;
  @Column({ type: 'varchar', default: 'car' }) vehicle: Vehicle;
  /** 0 = Sunday ... 6 = Saturday */
  @Column('simple-json') days: number[];
  /** HH:mm local time */
  @Column() departTime: string;
  @Column({ default: 10 }) thresholdMin: number;
  /** [lon, lat] pairs */
  @Column('simple-json') geometry: [number, number][];
  @Column('real') usualMin: number;
  @Column('real') distanceKm: number;
  @CreateDateColumn() createdAt: Date;
}

@Entity()
export class AppNotification {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() userId: number;
  @Column({ nullable: true }) routeId: number;
  @Column() type: string;
  @Column() title: string;
  @Column() body: string;
  @Index({ unique: true }) @Column() dedupeKey: string;
  @Column({ default: false }) read: boolean;
  /** 'up' | 'down' */
  @Column({ nullable: true }) feedback: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity()
export class Reminder {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() userId: number;
  @Column() title: string;
  /** HH:mm */
  @Column() time: string;
  /** 'once' | 'daily' */
  @Column({ default: 'once' }) repeat: string;
  /** YYYY-MM-DD for one-off reminders */
  @Column({ nullable: true }) date: string;
  /** YYYY-MM-DD the reminder was last marked done */
  @Column({ nullable: true }) doneOn: string;
  /** 'high' | 'medium' | 'low' */
  @Column({ type: 'varchar', default: 'medium' }) priority: string;
  @Column({ type: 'varchar', nullable: true }) note: string | null;
  /** Send a notification at the reminder's time. */
  @Column({ default: true }) notify: boolean;
  @CreateDateColumn() createdAt: Date;
}

@Entity()
export class WaterLog {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column() userId: number;
  /** YYYY-MM-DD */
  @Index() @Column() date: string;
  /** Millilitres in this drink; older logs were one 250 ml glass each. */
  @Column({ type: 'int', default: 250 }) ml: number;
  @CreateDateColumn() createdAt: Date;
}

export const ENTITIES = [User, SavedRoute, AppNotification, Reminder, WaterLog];
