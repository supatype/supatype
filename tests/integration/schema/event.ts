import type {
  DateOnly,
  DateTime,
  Default,
  Duration,
  Geo,
  GeoPoint,
  Int,
  LoggedIn,
  Model,
  Optional,
  Owner,
  Public,
  RelatedTo,
  RichText,
  Role,
  ServerDefault,
  Timestamp,
  UUID,
} from "@supatype/types"
import type { author } from "./blog.js"

export type event = Model<{
  id: UUID
  title: string
  description: Optional<RichText>
  startsAt: DateTime
  endsAt: Optional<DateTime>
  eventDate: Optional<DateOnly>
  createdTs: Optional<Timestamp>
  duration: Optional<Duration>
  location: Optional<GeoPoint>
  coverageArea: Optional<Geo>
  route: Optional<Geo>
  organizer: Optional<RelatedTo<author>>
  maxAttendees: Optional<Int>
  isPublic: Default<boolean, true>
  created_at: ServerDefault<Date>
  updated_at: ServerDefault<Date>
}, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"organizer_id">
    delete: Role<"service_role">
  }
}>
