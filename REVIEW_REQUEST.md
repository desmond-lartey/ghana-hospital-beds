# Safe Browsing review request

Paste this into Google Search Console, under Security & Manual Actions, Security
Issues, Request Review. Edit anything that is not accurate for you.

---

This site is an open-source student project that maps hospital bed availability
in Greater Accra, Ghana. It is not affiliated with any bank, hospital,
government agency or commercial service, and it does not imitate one.

The site has three parts:

1. A public map of hospitals showing reported bed, ICU and oxygen availability.
   No account is needed and nothing is collected from visitors.

2. A sign-in page for hospital staff who report their own ward's bed counts.
   It collects an email address and a password the user chooses. Nothing else.
   No payment details, no identity documents, no financial information.
   Authentication is handled by Supabase, an established provider.

3. A registration page where staff request access. An administrator confirms
   the person works at the hospital before the account can change anything.

I believe the warning is a false positive triggered by a styled sign-in page on
a shared *.vercel.app subdomain. To make the site's purpose and ownership clear
I have since added:

- An "About this site" panel on the sign-in page stating who runs the project,
  what the account is for, and that no financial or identity data is requested.
- The same statement on the registration page.
- A /.well-known/security.txt with a contact address and a description.
- A robots.txt and sitemap identifying the project.

The complete source code is public and can be reviewed at
https://github.com/desmond-lartey/ghana-hospital-beds — including every line
that runs on the sign-in page. There is no obfuscated code, no third-party
tracking, and no external form submission.

I would be grateful if you would re-review the site.
