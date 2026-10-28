---

## '@tslock/drizzle': patch

MySQL locks read `affectedRows` from the mysql2 `db.execute()` tuple `[ResultSetHeader, FieldPacket[]]`. Insert, update, and extend now succeed when that header reports a changed row.
