import type {
  Bytea,
  CIDR,
  DateTime,
  Default,
  FileAsset,
  IPAddress,
  MacAddress,
  Model,
  Optional,
  Role,
  ServerDefault,
  SmallInt,
  TSQuery,
  TSVector,
  UUID,
  XML,
} from "@supatype/types"
import type { auditLogsBucket } from "./buckets.js"

export type networkLog = Model<{
  id: UUID
  sourceIp: IPAddress
  subnet: Optional<CIDR>
  deviceMac: Optional<MacAddress>
  auditAttachment: Optional<FileAsset<auditLogsBucket>>
  payload: Optional<Bytea>
  rawXml: Optional<XML>
  searchQuery: Optional<TSQuery>
  searchVector: Optional<TSVector>
  severity: Default<SmallInt, 0>
  recordedAt: ServerDefault<DateTime>
  created_at: ServerDefault<Date>
  updated_at: ServerDefault<Date>
}, {
  access: {
    read: Role<"service_role">
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
