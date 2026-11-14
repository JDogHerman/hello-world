import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** Postgres `date` columns are returned as 'YYYY-MM-DD' strings (see pg type parser in kysely.ts). */
type DateString = string;

export type OfferStatus = 'queued' | 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export type ListStatus = 'draft' | 'pending_approval' | 'approved' | 'active' | 'filled' | 'exhausted' | 'cancelled';
export type PositionStatus = 'open' | 'filled' | 'exhausted' | 'cancelled';
export type JobStatus = 'open' | 'cancelled' | 'complete';
export type UserRole = 'admin' | 'steward';

export interface AppConfigTable {
  id: Generated<number>;
  reply_window_minutes: number;
  offers_per_open_slot: number;
  quiet_hours_start: string; // 'HH:MM:SS'
  quiet_hours_end: string;
  timezone: string;
  local_name: string;
  booking_buffer_minutes: number;
  steward_sms_alerts: boolean;
  updated_at: Generated<Date>;
}

export interface AppUserTable {
  id: Generated<number>;
  email: string;
  name: string;
  password_hash: string;
  role: UserRole;
  phone: string | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkerTable {
  id: Generated<number>;
  first_name: string;
  last_name: string;
  phone: string;
  tranche: number;
  start_date: DateString;
  active: Generated<boolean>;
  sms_opt_out: Generated<boolean>;
  opt_out_at: NullableTimestamp;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface NamedListTable {
  id: Generated<number>;
  name: string;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface VenueTable extends NamedListTable {
  address: Generated<string>;
}

export interface WorkerSkillTable {
  worker_id: number;
  skill_id: number;
}

export interface WorkerRefusalTable {
  id: Generated<number>;
  worker_id: number;
  job_type_id: number | null;
  venue_id: number | null;
  reason: Generated<string>;
  created_at: Generated<Date>;
}

export interface WorkerUnavailabilityTable {
  id: Generated<number>;
  worker_id: number;
  starts_at: Timestamp;
  ends_at: Timestamp;
  note: Generated<string>;
  created_at: Generated<Date>;
}

export interface JobTable {
  id: Generated<number>;
  venue_id: number;
  job_type_id: number;
  starts_at: Timestamp;
  est_end_at: Timestamp;
  notes: Generated<string>;
  status: Generated<JobStatus>;
  created_by: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PositionTable {
  id: Generated<number>;
  job_id: number;
  skill_id: number;
  quantity: number;
  filled_count: Generated<number>;
  status: Generated<PositionStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CandidateListTable {
  id: Generated<number>;
  position_id: number;
  status: Generated<ListStatus>;
  generated_at: Generated<Date>;
  approved_by: number | null;
  approved_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CandidateEntryTable {
  id: Generated<number>;
  list_id: number;
  worker_id: number;
  rank: number;
  source: Generated<'auto' | 'manual'>;
  removed_at: NullableTimestamp;
  removed_reason: string | null;
  skipped_reasons: string[] | null;
  created_at: Generated<Date>;
}

export interface CandidateExclusionTable {
  list_id: number;
  worker_id: number;
  reasons: string[];
}

export interface OfferTable {
  id: Generated<number>;
  position_id: number;
  worker_id: number;
  candidate_entry_id: number | null;
  code: string;
  status: OfferStatus;
  queued_at: Timestamp;
  sent_at: NullableTimestamp;
  expires_at: NullableTimestamp;
  responded_at: NullableTimestamp;
  reply_text: string | null;
  cancel_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BookingTable {
  id: Generated<number>;
  worker_id: number;
  job_id: number;
  position_id: number;
  offer_id: number | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  cancelled_at: NullableTimestamp;
  cancel_reason: string | null;
  created_at: Generated<Date>;
}

export interface SmsMessageTable {
  id: Generated<number>;
  direction: 'outbound' | 'inbound';
  worker_id: number | null;
  phone: string;
  body: string;
  offer_id: number | null;
  provider_sid: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'received' | 'skipped';
  not_before: Timestamp;
  attempts: Generated<number>;
  error: string | null;
  sent_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface AlertTable {
  id: Generated<number>;
  kind: string;
  job_id: number | null;
  position_id: number | null;
  message: string;
  acknowledged_by: number | null;
  acknowledged_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: Generated<Date>;
  actor_type: 'user' | 'worker' | 'system';
  actor_id: number | null;
  actor_label: Generated<string>;
  action: string;
  entity: string;
  entity_id: number | null;
  reason: string | null;
  data: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface Database {
  app_config: AppConfigTable;
  app_user: AppUserTable;
  worker: WorkerTable;
  skill: NamedListTable;
  job_type: NamedListTable;
  venue: VenueTable;
  worker_skill: WorkerSkillTable;
  worker_refusal: WorkerRefusalTable;
  worker_unavailability: WorkerUnavailabilityTable;
  job: JobTable;
  position: PositionTable;
  candidate_list: CandidateListTable;
  candidate_entry: CandidateEntryTable;
  candidate_exclusion: CandidateExclusionTable;
  offer: OfferTable;
  booking: BookingTable;
  sms_message: SmsMessageTable;
  alert: AlertTable;
  audit_log: AuditLogTable;
}

export type Worker = Selectable<WorkerTable>;
export type NewWorker = Insertable<WorkerTable>;
export type WorkerUpdate = Updateable<WorkerTable>;
export type Job = Selectable<JobTable>;
export type Position = Selectable<PositionTable>;
export type Offer = Selectable<OfferTable>;
export type CandidateList = Selectable<CandidateListTable>;
export type CandidateEntry = Selectable<CandidateEntryTable>;
export type AppConfig = Selectable<AppConfigTable>;
export type AppUser = Selectable<AppUserTable>;
export type SmsMessage = Selectable<SmsMessageTable>;
