import { model, field, bucket, access, publishable } from "@supatype/schema"

export const avatars    = bucket("avatars",      { accessMode: "public" })
export const postImages = bucket("post-images",  { accessMode: "public" })

export const User = model("user", {
  fields: {
    name: field.text({ required: true }),
    avatarUrl: field.image({ bucket: avatars }),
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
    coverImage: field.image({ bucket: postImages }),
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
