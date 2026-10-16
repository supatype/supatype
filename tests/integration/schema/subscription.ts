import type {
  BigInt,
  DateTime,
  Decimal,
  Default,
  Indexed,
  Int,
  JSON,
  MaxLength,
  Model,
  Optional,
  Owner,
  RelatedTo,
  Role,
  ServerDefault,
  UUID,
  Unique,
} from "@supatype/types"
import type { author } from "./blog.js"

export type subscription = Model<{
  id: UUID
  subscriber: RelatedTo<author, { required: true; onDelete: "cascade" }>
  externalId: Unique<BigInt>
  planId: Indexed<UUID>
  status: Default<"trialing" | "active" | "past_due" | "canceled" | "unpaid", "trialing">
  billingPeriod: Default<"monthly" | "annual", "monthly">
  currentPeriodEnd: DateTime
  trialEndsAt: Optional<DateTime>
  canceledAt: Optional<DateTime>
  quantity: Default<Int, 1>
  unitAmount: Decimal<12, 2>
  currency: Default<MaxLength<string, 3>, "usd">
  metadata: Optional<JSON<Record<string, string>>>
  created_at: ServerDefault<Date>
  updated_at: ServerDefault<Date>
}, {
  access: {
    read: Owner<"subscriber_id">
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
