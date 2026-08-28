We are building a real-time 3D multiplayer browser-based Sumo game where players move around a circular arena using WASD, jump using the SPACEbar, and try to push opponents out. The last player inside the ring wins.

Please create a complete master plan for the entire project from scratch, covering:
1. Project structure (Node.js backend with Express & Socket.io + Frontend with Vite & Three.js).
2. Character design: Render each player as a simple 3D human-like avatar (composed of basic geometries like a head, torso, and limbs) with their name floating above them.
3. Controls & Actions: 
   - Movement via WASD.
   - Jumping via the SPACEbar (with basic gravity/jump physics).
   - Shove/Push mechanic: Pressing the 'F' key extends visual arms forward to push nearby opponents with an active knockback force, synchronized across all players.
4. Physics and game rules: Circle boundary detection, player-to-player collision, knockback physics when shoved or hit, and elimination when falling out of the ring.
5. Real-time synchronization: Handling connections, disconnections, position/action updates, and smooth interpolation so other players move without stuttering.

Review your plan, and immediately start executing it end-to-end: create all directories, write the package.json files, implement the server code with physics/collision logic, write the client HTML/JS files with Three.js (including the human avatars and F-key punch/push animation), and configure everything so we can run and test the game locally right away. Execute the full implementation without stopping.