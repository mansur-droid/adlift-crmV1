# AdLift CRM role setup

The CRM reads the logged-in Supabase user's role from either `app_metadata.role` or `user_metadata.role`.

Supported roles:

- `admin`: full CRM access, including dashboard, leads, clients, freelancers, submissions, stats, import, export, edit, and delete.
- `freelancer`: limited CRM access to dashboard, submissions, and cold-call stats. Freelancers can add/edit records in those sections but cannot delete records or import/export data.

Use `app_metadata.role` when possible. It is safer than `user_metadata.role` because users cannot update app metadata from the browser client.

Admin metadata example:

```json
{
  "role": "admin"
}
```

Freelancer metadata example:

```json
{
  "role": "freelancer"
}
```

Supabase setup:

1. Go to Supabase.
2. Open Authentication > Users.
3. Select the user.
4. Add the role value in user metadata or app metadata.
5. Save the user.
6. Tell the user to log out and log back in.

Important: this PR adds role-based UI restrictions in the React app. When this CRM starts storing records in Supabase tables instead of localStorage, add Row Level Security policies so admins and freelancers are also restricted at the database level.
