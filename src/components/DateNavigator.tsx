import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import type { Language, ReportListItem } from "../types";

interface Props {
  archive: ReportListItem[];
  selectedDate: string;
  language: Language;
  selectLabel: string;
  newerLabel: string;
  olderLabel: string;
}

export default function DateNavigator({
  archive,
  selectedDate,
  language,
  selectLabel,
  newerLabel,
  olderLabel,
}: Props) {
  const index = archive.findIndex((item) => item.reportDate === selectedDate);
  const newer = index > 0 ? archive[index - 1] : null;
  const older =
    index >= 0 && index < archive.length - 1 ? archive[index + 1] : null;

  function navigate(date: string) {
    const url = new URL(window.location.href);
    if (date === archive[0]?.reportDate) url.searchParams.delete("date");
    else url.searchParams.set("date", date);
    window.location.assign(`${url.pathname}${url.search}`);
  }

  function optionLabel(item: ReportListItem) {
    const edition = String(item.edition).padStart(2, "0");
    return language === "zh"
      ? `${item.reportDate} · 第 ${edition} 期`
      : `${item.reportDate} · Edition ${edition}`;
  }

  return (
    <div className="date-nav">
      <Button
        className="date-arrow"
        isDisabled={!newer}
        onPress={() => newer && navigate(newer.reportDate)}
        aria-label={newerLabel}
      >
        <ArrowLeft aria-hidden="true" />
      </Button>
      <Select
        className="date-select"
        aria-label={selectLabel}
        value={selectedDate}
        onChange={(key) => navigate(String(key))}
      >
        <Label className="sr-only">{selectLabel}</Label>
        <Button className="date-select-trigger">
          <SelectValue />
          <ChevronDown aria-hidden="true" />
        </Button>
        <Popover className="date-popover" placement="bottom">
          <ListBox className="date-listbox">
            {archive.map((item) => (
              <ListBoxItem
                className="date-option"
                id={item.reportDate}
                key={item.reportDate}
                textValue={optionLabel(item)}
              >
                {optionLabel(item)}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </Select>
      <Button
        className="date-arrow"
        isDisabled={!older}
        onPress={() => older && navigate(older.reportDate)}
        aria-label={olderLabel}
      >
        <ArrowRight aria-hidden="true" />
      </Button>
    </div>
  );
}
