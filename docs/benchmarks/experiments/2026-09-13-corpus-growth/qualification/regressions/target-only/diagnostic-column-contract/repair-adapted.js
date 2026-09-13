"use strict";
module.exports = function (context) {
    function stringRepeat(str, num) {
        var result = "";
        for (num |= 0; num > 0; num >>>= 1, str += str) {
            if (num & 1) {
                result += str;
            }
        }
        return result;
    }
    var tabWidth = context.options[1] || 4;
    var maxLength = context.options[0] || 80, tabString = stringRepeat(" ", tabWidth);
    function checkProgramForMaxLength(node) {
        var lines = context.getSourceLines();
        lines.forEach(function (line, i) {
            if (line.replace(/\t/g, tabString).length > maxLength) {
                context.report(node, { line: i + 1, column: 0 }, "Line " + (i + 1) + " exceeds the maximum line length of " + maxLength + ".");
            }
        });
    }
    return {
        "Program": checkProgramForMaxLength
    };
};
module.exports.schema = [
    {
        "type": "integer",
        "minimum": 0
    },
    {
        "type": "integer",
        "minimum": 0
    }
];
