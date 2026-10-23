"use strict";

// What's new in BLACKBOX itself (shown from the sidebar). Newest first; add an entry for every change.
const CHANGELOG = [
  {
    version: "1.6",
    date: "2026-10-23",
    title: "Ready for everyone",
    items: [
      "Sign in with your Google account, or with email and password",
      "Install BLACKBOX as an app on your computer or phone (offline support included)",
      "Redesigned chat: full height, coloured names, cleaner composer, a “New messages” button when you scroll up",
      "Smoother page changes with soft cross-fades",
      "Mobile layout: top bar, bottom tabs, task cards, bottom sheets, swipeable board",
      "Slightly bigger text and spacing; more room between the logo and the bell",
      "What's new moved to the notifications panel and your profile",
      "On phones, pop-up messages no longer cover the chat box",
    ],
  },
  {
    version: "1.5",
    date: "2026-10-23",
    title: "Teams, channels and patch notes",
    items: [
      "Roles and permissions: Owner, Admin, Member and Viewer",
      "Chat channels like Discord, with an unread dot per channel",
      "@mentions in chat and a notification bell (mentions, assigned tasks, published updates, role changes)",
      "Kanban board for tasks and bugs: drag cards between columns, with mouse or finger",
      "Updates page for your game's patch notes, filled from completed tasks and fixed bugs",
      "Folders in Assets: create, rename, delete, and drag files into them",
      "Download button on chat images, in the image viewer and in Assets",
      "Faster uploads (in parallel, large images resized first); messages appear instantly while sending",
      "Smoother pages: updates in place without flicker, soft transitions, images fade in when loaded",
      "This What's new list",
      "Fixes from a code review: safer permissions and notifications, no lost or doubled messages when switching projects or retrying, read-only release and items for Viewers, more reliable mentions and board ordering",
    ],
  },
  {
    version: "1.4",
    date: "2026-10-23",
    title: "Chat media, assets, profiles and audit log",
    items: [
      "Styled dropdowns, menus and scrollbars; no counters in the navigation",
      "Discord-style chat: bold, italic, strikethrough, code, quotes, images, GIF library, edit and delete",
      "Assets page for images, thumbnails, icons and GIFs",
      "Collections with images, grid or list view",
      "Game icon, thumbnail, platform icons and tags in project settings",
      "Profile: photo, name, role, contact email; email and password change",
      "Activity: full audit log with icons, filters and change details",
      "Save indicator; typed text survives teammates' changes",
      "Security fixes from a code review",
    ],
  },
  {
    version: "1.3",
    date: "2026-10-23",
    title: "Artifact edition",
    items: ["BLACKBOX runs as a shared claude.ai page with Claude accounts", "Join a project with one click"],
  },
  {
    version: "1.2",
    date: "2026-10-23",
    title: "Real accounts and teams",
    items: [
      "Sign in with email and password, email confirmation",
      "Projects shared in real time; invite teammates by email",
      "Task menu with Edit, Up, Down and Delete",
      "Chat separated from Activity",
    ],
  },
  { version: "1.1", date: "2026-10-23", title: "In-app dialogs", items: ["Confirmations and prompts work inside shared pages"] },
  { version: "1.0", date: "2026-10-23", title: "First dashboard", items: ["Overview, tasks, bugs, release checklist, collections and activity"] },
];
const APP_VERSION = CHANGELOG[0].version;
