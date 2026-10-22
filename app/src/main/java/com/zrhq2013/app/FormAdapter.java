package com.zrhq2013.app;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

public class FormAdapter extends RecyclerView.Adapter<FormAdapter.FormViewHolder> {

    public interface OnFormActionListener {
        void onDownload(TaxForm form);
    }

    private final List<TaxForm> items = new ArrayList<>();
    private final OnFormActionListener listener;

    public FormAdapter(OnFormActionListener listener) {
        this.listener = listener;
    }

    public void submit(List<TaxForm> forms) {
        items.clear();
        items.addAll(forms);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public FormViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_form, parent, false);
        return new FormViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull FormViewHolder holder, int position) {
        TaxForm form = items.get(position);
        holder.name.setText(form.title);
        holder.meta.setText(form.uploadDate + " · " + form.sizeText);
        holder.download.setOnClickListener(v -> {
            if (listener != null) {
                listener.onDownload(form);
            }
        });
        holder.itemView.setOnClickListener(v -> {
            if (listener != null) {
                listener.onDownload(form);
            }
        });
    }

    @Override
    public int getItemCount() {
        return items.size();
    }

    static class FormViewHolder extends RecyclerView.ViewHolder {
        final TextView name;
        final TextView meta;
        final TextView download;

        FormViewHolder(@NonNull View itemView) {
            super(itemView);
            name = itemView.findViewById(R.id.tv_form_name);
            meta = itemView.findViewById(R.id.tv_form_meta);
            download = itemView.findViewById(R.id.btn_download);
        }
    }
}
