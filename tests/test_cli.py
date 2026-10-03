from pytest import CaptureFixture

from jev_scam_detector import main


def test_main_prints_greeting(capsys: CaptureFixture[str]) -> None:
    main()
    assert capsys.readouterr().out == "Hello from jev-scam-detector!\n"
