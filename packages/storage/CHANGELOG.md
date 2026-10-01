# Changelog

## Unreleased

### Bug Fixes

* **signed URLs:** a signed URL must carry this service's own token. Any token without a `.` was
  passed through for S3 to validate, and the object was then fetched with the service's own
  credentials, so `GET /object/sign/<bucket>/<path>?token=x` read any private object with no
  session. Every bucket now gets the service's token, resolved to the live version when used; a
  public bucket's S3 presigned URL stopped working once its object was overwritten.
* **buckets:** emptying a bucket deletes the bytes inside the transaction that deletes the rows,
  so a failing object store rolls the rows back and the empty can be retried.
* **objects:** uploads, overwrites, deletes and lists run as the caller, so the row level security
  policies generated from each bucket's rules decide them. They ran on the owner connection, which
  bypasses those policies, and the service decided access itself from `access_mode` alone:
  * the anon key could upload to a bucket declaring `create: BucketLoggedIn` (supatype#81);
  * any signed-in user could delete any other user's objects under `delete: BucketOwner`, and the
    files were removed from S3 before anything was checked (supatype#82);
  * an overwrite was checked only on private buckets, so anyone signed in could replace another
    user's file in a public one;
  * a list returned every object's name and metadata in a private bucket.
* **objects:** a `custom` bucket asks its read rule. It let every signed-in caller read every
  object through a placeholder that was never replaced.
* **objects:** an upload stores its bytes only once Postgres has accepted the row, and a failed
  S3 write leaves no row behind. A delete removes from S3 only the names Postgres deleted, after
  the transaction commits. A delete the rule refuses leaves the object in place and out of the
  response.
* **objects:** an overwrite keeps the object's owner. It was reassigned to whoever wrote last.
* **objects:** a list prefix is matched as text. It was a `LIKE` pattern, so `%` and `_` in a
  prefix matched other names.
* **objects:** a database that predates the grants these writes need refuses with an explanation
  and a log line naming `supatype push`, rather than a 500 naming a Postgres table.
