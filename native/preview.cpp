#include "RoboArm/DualArmProfiles.hpp"
#include "RoboArm/UrdfRneaProfiles.hpp"
#include "Runtime/Eng27/Profiles.hpp"
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace ConceptArm;
namespace {
using Angles = JointAngles<7>;
struct Frame {
    Angles q;
    unsigned intervalMs;
    bool settle{};
};

void writeAngles(Angles const& q) {
    std::cout << '[';
    for (std::size_t i = 0; i < q.size(); ++i)
        std::cout << (i ? "," : "") << q[i].to<float>();
    std::cout << ']';
}
}  // namespace

int main() {
    int side, safe, payload;
    float pitchDeg;
    std::size_t count;
    if (!(std::cin >> side >> safe >> payload >> pitchDeg >> count) ||
        (side != 0 && side != 1) || !std::isfinite(pitchDeg) ||
        std::abs(pitchDeg) > 180 || count < 2 || count > 10000) return 1;
    // The optional header flag adds one settle bit after the interval field.
    std::string headerTail;
    std::getline(std::cin, headerTail);
    std::istringstream header{headerTail};
    bool withSettle = false;
    if (header >> std::ws; !header.eof()) {
        int version;
        if (!(header >> version) || version != 1) return 1;
        withSettle = true;
    }
    std::vector<Frame> frames(count);
    unsigned totalMs = 0;
    for (std::size_t i = 0; i < count; ++i) {
        auto& frame = frames[i];
        if (!(std::cin >> frame.intervalMs) || frame.intervalMs > 600000 ||
            (i + 1 < count && frame.intervalMs == 0)) return 1;
        if (withSettle) {
            int settle;
            if (!(std::cin >> settle) || (settle != 0 && settle != 1)) return 1;
            frame.settle = settle == 1;
        }
        totalMs += frame.intervalMs;
        if (totalMs > 600000) return 1;
        for (auto& angle : frame.q) {
            float value;
            if (!(std::cin >> value) || !std::isfinite(value)) return 1;
            angle = Angle{value};
        }
    }

    auto const& poe = side == 0 ? dualArm::leftPoe : dualArm::rightPoe;
    auto const& safety = side == 0 ? dualArm::leftSafety : dualArm::rightSafety;
    auto const profile = dualArm::makePositionProfile(side == 0);
    trajectory::Constraints<7> const constraints{safety.jointLimit, safety.velocityLimit,
        profile.accelerationLimit, profile.jerkLimit, profile.crawlSpeed};
    auto environment = dualArm::makeEnvironment();
    auto const pitch = Angle{units::angle::degree_t{pitchDeg}};
    environment.baseFromArm.linear() =
        Eigen::AngleAxisf{-pitch.to<float>(), Eigen::Vector3f::UnitY()}.toRotationMatrix();
    if (payload) environment.tcpFromtool.translation() = Concept::eng27::tcpFromToolOffset();

    auto writePosition = [&](Angles const& q) {
        Pose pose;
        kinematics::forwardKinematics(poe, q, environment.baseFromArm, environment.tcpFromtool, pose);
        for (auto const value : pose.position) std::cout << ',' << value.to<float>();
    };

    auto const recordedStart = frames.front().q;
    if (safe) frames.front().q = Concept::eng27::machineProfile.resetSafe;
    std::cout << std::setprecision(9) << "{\"start\":";
    writeAngles(frames.front().q);
    auto const rnea = side == 0 ? urdfDynamics::makeLeftProfile() : urdfDynamics::makeRightProfile();
    auto const screws = poe.screwAxes();
    std::cout << ",\"model\":[";
    for (Eigen::Index i = 0; i < screws.cols(); ++i) {
        auto const origin = rnea.links[static_cast<std::size_t>(i)].armFromLinkHome.translation();
        std::cout << (i ? ",[" : "[") << screws(0, i);
        for (Eigen::Index row = 1; row < screws.rows(); ++row) std::cout << ',' << screws(row, i);
        for (Eigen::Index row = 0; row < origin.size(); ++row) std::cout << ',' << origin[row];
        std::cout << ']';
    }
    Eigen::Vector3f const tcpHome = Transform4f{poe.homeTransform()} * environment.tcpFromtool.translation();
    std::cout << "],\"tcpHome\":[" << tcpHome.x() << ',' << tcpHome.y() << ',' << tcpHome.z()
              << "],\"tcpBasis\":[";
    Eigen::Matrix3f const rotation = poe.homeTransform().topLeftCorner<3, 3>() * environment.tcpFromtool.linear();
    for (Eigen::Index i = 0; i < 3; ++i) {
        std::cout << (i ? ",[" : "[") << rotation(0, i) << ',' << rotation(1, i)
                  << ',' << rotation(2, i) << ']';
    }
    std::cout << "],\"recorded\":[";
    for (std::size_t i = 0; i < count; ++i) {
        std::cout << (i ? ",[" : "[") << i;
        writePosition(i == 0 ? recordedStart : frames[i].q);
        std::cout << ']';
    }

    // Frame zero is the assumed initial pose. Subsequent submissions follow
    // the edited intervals and use the active reference as their initial state.
    std::array<trajectory::MotionState, 7> state{};
    for (std::size_t axis = 0; axis < state.size(); ++axis)
        state[axis].position = frames.front().q[axis].to<float>();
    trajectory::Workspace<7> workspace{};
    trajectory::Trajectory<7> active{};
    Angles target = frames.front().q;
    unsigned submittedMs = 0;
    unsigned clockMs = 0;
    std::vector<unsigned> frameTimes(count);
    bool first = true;
    std::cout << "],\"planned\":[";
    auto sample = [&](float elapsed) {
        Angles angles{};
        for (std::size_t axis = 0; axis < state.size(); ++axis) {
            state[axis] = trajectory::sample(active.axes[axis], elapsed);
            angles[axis] = Angle{state[axis].position};
        }
        std::cout << (first ? "[" : ",[") << static_cast<float>(submittedMs) / 1000.0f + elapsed;
        writePosition(angles);
        std::cout << ',';
        writeAngles(angles);
        std::cout << ']';
        first = false;
    };
    auto const initial = trajectory::plan(state, target, constraints, profile.samplePeriod, workspace, active);
    std::size_t rejected = std::holds_alternative<Error>(initial) ? 1 : 0;
    for (std::size_t i = 1; i < count && !rejected; ++i) {
        unsigned const previousMs = clockMs;
        auto& previous = frames[i - 1];
        if (previous.settle) {
            float const remaining = active.duration - static_cast<float>(clockMs - submittedMs) / 1000.0f;
            if (remaining > 0.0f) {
                auto const neededMs = static_cast<unsigned>(std::ceil(remaining * 1000.0f));
                if (neededMs > previous.intervalMs) {
                    totalMs += neededMs - previous.intervalMs;
                    if (totalMs > 600000) return 1;
                    previous.intervalMs = neededMs;
                }
            }
        }
        // StoreFetch submits when elapsed >= the incoming target's duration.
        // The request stores intervals after each frame; export shifts them by one.
        clockMs += ((previous.intervalMs + 1) / 2) * 2;
        frameTimes[i] = clockMs;
        float const elapsed = static_cast<float>(clockMs - submittedMs) / 1000.0f;
        for (float offset = static_cast<float>(previousMs - submittedMs) / 1000.0f;
             offset < elapsed; offset += 0.02f) sample(offset);
        sample(elapsed);
        if (frames[i].q == target) continue;
        if (std::holds_alternative<Error>(
                trajectory::plan(state, frames[i].q, constraints, profile.samplePeriod, workspace, active))) {
            rejected = i + 1;
            break;
        }
        target = frames[i].q;
        submittedMs = clockMs;
    }
    float const sinceSubmission = static_cast<float>(clockMs - submittedMs) / 1000.0f;
    float const end = static_cast<float>(submittedMs) / 1000.0f + std::max(sinceSubmission, active.duration);
    if (!rejected) {
        for (float offset = sinceSubmission; offset < active.duration; offset += 0.02f) sample(offset);
        sample(std::max(sinceSubmission, active.duration));
    }
    std::cout << "],\"intervals\":[";
    for (std::size_t i = 0; i < count; ++i)
        std::cout << (i ? "," : "") << frames[i].intervalMs;
    std::cout << "],\"frameTimes\":[";
    for (std::size_t i = 0; i < count; ++i)
        std::cout << (i ? "," : "") << frameTimes[i];
    std::cout << "],\"submitted\":" << static_cast<float>(clockMs) / 1000.0f
              << ",\"end\":" << end << ",\"rejected\":" << rejected << "}\n";
}
