const commands = [];

function cmd(info, func) {
    if (!info) throw new Error("Command info missing");
    const data = {
        pattern: info.pattern || null,
        alias: info.alias || [],
        desc: info.desc || '',
        category: info.category || 'misc',
        function: func
    };
    commands.push(data);
    return data;
}

function findCommand(name) {
    if (!name) return null;
    name = name.toLowerCase();
    return commands.find(cmd => 
        cmd.pattern?.toLowerCase() === name || 
        cmd.alias?.map(a => a.toLowerCase()).includes(name)
    ) || null;
}

module.exports = { cmd, commands, findCommand };
