import { model, field, access } from "@supatype/schema"

export const User = model("user", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    email: field.email({ required: true, unique: true }),
    name: field.text({ required: true }),
  },
  access: {
    read: access.public(),
    create: access.public(),
    update: access.owner("id"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})
