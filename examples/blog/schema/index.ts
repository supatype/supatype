import { model, field, access, publishable } from "@supatype/schema"

export const User = model("user", {
  fields: {
    name: field.text({ required: true }),
    avatarUrl: field.image({ bucket: "avatars", required: false }),
  },
  access: {
    read: access.authenticated(),
    create: access.authenticated(),
    update: access.owner("user_id"),
    delete: access.owner("user_id"),
  },
  options: { timestamps: true },
})

export const Post = model("post", {
  fields: {
    title: field.text({ required: true }),
    slug: field.slug({ from: "title" }),
    body: field.richText({ required: true }),
    coverImage: field.image({ bucket: "post-images", required: false }),
    authorId: field.uuid({ required: true }),
    publishInfo: publishable(),
  },
  access: {
    read: access.public(),
    create: access.authenticated(),
    update: access.owner("author_id"),
    delete: access.owner("author_id"),
  },
  options: { timestamps: true },
})

export const Comment = model("comment", {
  fields: {
    postId: field.uuid({ required: true }),
    authorId: field.uuid({ required: true }),
    body: field.text({ required: true }),
  },
  access: {
    read: access.public(),
    create: access.authenticated(),
    update: access.owner("author_id"),
    delete: access.owner("author_id"),
  },
  options: { timestamps: true },
})
