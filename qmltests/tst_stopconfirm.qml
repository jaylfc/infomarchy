import QtQuick
import QtTest

// Reproduces the inspector's END PROCESS tag, because the question Fred asked
// cannot be answered by reading source: does ONE click kill, or does it only
// arm? A string match sees the `if (armed)` branch and says "two clicks" while
// a real pointer might deliver two events, or a rebuild might arm and fire in
// the same gesture. This drives actual clicks and counts the kills.
//
// It also covers the two states that made the old control feel broken: the
// armed state expiring on a timer, and the drawer re-resolving its session on
// every 4 s snapshot while the tag stays armed.
Item {
  id: root
  width: 320; height: 120

  property int kills: 0
  property bool armed: false
  // Stands in for view.inspectedSession being re-resolved against each new
  // snapshot. The real drawer replaces this object every tick.
  property var session: ({ pid: 1234, project: "infomarchy", stale: false })

  Rectangle {
    objectName: "endTag"
    anchors.centerIn: parent
    width: 220; height: 32
    color: root.armed ? "#a33" : "#885"

    Text {
      anchors.centerIn: parent
      color: "white"
      text: root.armed ? "CONFIRM: END " + String(root.session.project || "THIS SESSION").toUpperCase() : "END PROCESS"
    }

    MouseArea {
      objectName: "endClick"
      anchors.fill: parent
      onClicked: {
        if (root.armed) { root.kills++; root.armed = false }
        else root.armed = true
      }
    }

    Timer {
      objectName: "disarm"
      interval: 4000
      running: root.armed
      onTriggered: root.armed = false
    }
  }

  TestCase {
    name: "EndProcessNeedsTwoClicks"
    when: windowShown

    function init() { root.kills = 0; root.armed = false }

    function test_one_click_only_arms() {
      var tag = findChild(root, "endTag");
      mouseClick(tag);
      compare(root.armed, true, "first click must arm");
      compare(root.kills, 0, "FIRST CLICK MUST NOT KILL");
    }

    function test_second_click_kills_once() {
      var tag = findChild(root, "endTag");
      mouseClick(tag);
      mouseClick(tag);
      compare(root.kills, 1, "second click kills exactly once");
      compare(root.armed, false, "and disarms after firing");
    }

    function test_a_snapshot_tick_does_not_fire_it() {
      // The drawer re-resolves its session every 4 s. Replacing the object
      // must not kill anything by itself, and must not silently disarm the
      // tag either, or the second click lands on an unarmed control and the
      // operator clicks a third time wondering why nothing happened.
      var tag = findChild(root, "endTag");
      mouseClick(tag);
      compare(root.armed, true);
      root.session = { pid: 1234, project: "infomarchy", stale: false };
      compare(root.kills, 0, "a tick must not kill");
      compare(root.armed, true, "a tick must not disarm");
      mouseClick(tag);
      compare(root.kills, 1);
    }

    function test_arming_expires_on_its_own() {
      var tag = findChild(root, "endTag");
      mouseClick(tag);
      compare(root.armed, true);
      // The real timer is 4 s; wait past it rather than reaching into it.
      wait(4300);
      compare(root.armed, false, "arming must expire so a stray click cannot sit armed");
      compare(root.kills, 0);
    }
  }
}
