// Seed data used on first launch (or after a reset). Everything else lives in localStorage.
const SEED = {
  currentProject: "baddie-dice",
  members: {
    miiso: { name: "Miiso", role: "Project Owner", color: "#22d3ee", accent: "#0e7490" },
    void: { name: "Void", role: "Developer", color: "#4ade80", accent: "#166534" },
    zen: { name: "Zen", role: "Artist", color: "#a1a1aa", accent: "#3f3f46" },
  },
  me: "miiso",
  projects: {
    "baddie-dice": {
      name: "Baddie Dice",
      tags: ["Roblox", "RNG / Collection"],
      description: "Roll dice, collect rare characters, and grow your collection.",
      team: ["miiso", "void", "zen"],
      tasks: [
        { id: 1, type: "task", icon: "file", title: "Fix auto-roll on mobile", desc: "Auto-roll sometimes stops on mobile devices.", priority: "critical", status: "progress", owner: "miiso" },
        { id: 2, type: "task", icon: "file", title: "Check inventory saving", desc: "Items not always saving after rejoin.", priority: "high", status: "todo", owner: "void" },
        { id: 3, type: "task", icon: "image", title: "Finish rank icons", desc: "Create icons for S, SS, SSS ranks.", priority: "medium", status: "review", owner: "zen" },
        { id: 4, type: "task", icon: "list", title: "Add quest rewards", desc: "Implement rewards and UI flow.", priority: "medium", status: "todo", owner: "miiso" },
        { id: 5, type: "task", icon: "palette", title: "Polish profile menu", desc: "UI tweaks and transitions.", priority: "low", status: "progress", owner: "void" },
        { id: 6, type: "task", icon: "file", title: "Daily login bonus", desc: "Reward streak for consecutive days.", priority: "low", status: "todo", owner: "void" },
        { id: 7, type: "task", icon: "image", title: "Rank SSS icon", desc: "Final artwork for the SSS rank.", priority: "medium", status: "done", owner: "miiso" },
        { id: 8, type: "task", icon: "file", title: "Core dice system", desc: "Roll logic, odds table and animations.", priority: "high", status: "done", owner: "void" },
        { id: 9, type: "bug", icon: "bug", title: "Mobile auto-roll stops", desc: "Auto-roll halts after the app goes to background.", priority: "critical", status: "todo", owner: "void" },
        { id: 10, type: "bug", icon: "bug", title: "Duplicate characters in index", desc: "Some characters appear twice in the collection.", priority: "medium", status: "todo", owner: "zen" },
        { id: 11, type: "bug", icon: "bug", title: "Shop prices flicker", desc: "Prices briefly show 0 when opening the shop.", priority: "low", status: "progress", owner: "miiso" },
      ],
      release: {
        name: "UPDATE 1",
        due: "Oct 25",
        items: [
          { label: "Core dice system (finalize)", done: true },
          { label: "Inventory saving fixes", done: true },
          { label: "Quest rewards and UI", done: false },
        ],
      },
      collections: [
        { id: "characters", name: "Characters", desc: "Collection of playable characters and assets.", art: "characters", items: ["Baddie #1", "Baddie #2"] },
        { id: "maps", name: "Maps", desc: "Map files, locations and environments.", art: "maps", items: ["Lobby", "Night street"] },
        { id: "ui", name: "UI & Icons", desc: "Interface assets, icons and menu elements.", art: "ui", items: ["Dice icon"] },
      ],
      activity: [
        { who: "miiso", kind: "done", text: "completed <b>Rank SSS icon</b>", where: "UI & Icons", at: Date.now() - 2 * 3600e3 },
        { who: "zen", kind: "update", text: "updated <b>Map layout</b>", where: "Maps", at: Date.now() - 5 * 3600e3 },
        { who: "void", kind: "bug", text: "reported a new bug", detail: "Mobile auto-roll sometimes stops", where: "Bugs", at: Date.now() - 6 * 3600e3 },
      ],
      chat: [
        { who: "void", text: "Pushed the inventory fix, can someone test on mobile?", at: Date.now() - 3 * 3600e3 },
        { who: "zen", text: "Rank icons are almost done 🎨", at: Date.now() - 2.5 * 3600e3 },
      ],
    },
  },
};
